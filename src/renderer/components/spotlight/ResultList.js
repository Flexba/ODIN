import React from 'react'
import { withStyles } from '@material-ui/core/styles'
import List from '@material-ui/core/List'
import ListItem from '@material-ui/core/ListItem'
import { noop } from '../../../shared/combinators'

class ResultList extends React.Component {

  constructor(props) {
    super(props)
  }

  handleKeyDown(event) {
    if(event.key !== 'Escape') return
    event.stopPropagation()
    const onUpdate = result => (this.props.onUpdate || noop)(result)
    onUpdate([])
  }

  handleClick(key) {
    const onSelect = this.props.options.onSelect || noop
    this.props.rows
      .filter(row => row.key === key)
      .forEach(onSelect)
  }

  handleDoubleClick(key) {
    this.handleClick(key)
    ;(this.props.options.onClose || noop)()
  }

  render() {
    const { classes } = this.props

    const rows = () => (this.props.rows || []).map(row => (
      <ListItem
        button
        divider={ true }
        key={ row.key }
        onClick={ () => this.handleClick(row.key) }
        onDoubleClick={ () => this.handleDoubleClick(row.key) }
      >
        { this.props.options.listItemText(row) }
      </ListItem>
    ))

    return (
      <List
        dense={ true }
        className={ classes.list }
        onKeyDown={ event => this.handleKeyDown(event) }
      >
        { rows() }
      </List>
    )
  }
}

const styles = theme => ({
  list: {
    overflow: 'scroll',
    maxHeight: 'fill-available',
    flexGrow: 1
  }
})

export default withStyles(styles)(ResultList)