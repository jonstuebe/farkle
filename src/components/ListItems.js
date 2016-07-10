import React from 'react';

const ListItems = React.createClass({
	render(){
		return (
			<div className="list-items">
				{this.props.children}
			</div>
		)
	}
});

export default ListItems;
